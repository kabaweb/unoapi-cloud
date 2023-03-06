import makeWASocket, { DisconnectReason, WASocket, isJidBroadcast, UserFacingSocketConfig, ConnectionState } from '@adiwajshing/baileys'
import { Boom } from '@hapi/boom'
import { Client } from './client'
import { store } from './store'
import { DataStore } from './data_store'
import { v1 as uuid } from 'uuid'
import { phoneNumberToJid, isIndividualJid } from './transformer'
const counts: Map<string, number> = new Map()
const connectings: Map<string, number> = new Map()
const max = 6

const onQrCode = async (client: Client, qrCode: string) => {
  counts.set(client.phone, (counts.get(client.phone) || 0) + 1)
  console.debug(`Received qrcode ${qrCode}`)
  const messageTimestamp = new Date().getTime()
  const mediaKey = uuid()
  await client.receive([
    {
      key: {
        remoteJid: phoneNumberToJid(client.phone),
        id: mediaKey,
      },
      message: {
        imageMessage: {
          url: qrCode,
          mimetype: 'image/png',
          fileName: `qrcode-unoapi-${messageTimestamp}.png`,
          mediaKey,
          fileLength: qrCode.length,
          caption: `Please, read the QR Code to connect on Whatsapp Web, attempt ${counts.get(client.phone)} of ${max}`,
        },
      },
      messageTimestamp,
    },
  ])
  if ((counts.get(client.phone) || 0) >= max) {
    counts.delete(client.phone)
    connectings.delete(client.phone)
    return false
  }
  return true
}

export declare type Connection = {
  sock: WASocket
  dataStore: DataStore
}

export const connect = async ({ store, client }: { store: store; client: Client }): Promise<Connection> => {
  const { state, saveCreds, dataStore } = await store(client.phone)
  const config: UserFacingSocketConfig = {
    printQRInTerminal: true,
    auth: state,
    shouldIgnoreJid: (jid: string) => isJidBroadcast(jid),
  }
  const sock = await makeWASocket(config)
  dataStore.bind(sock.ev)
  sock.ev.on('creds.update', saveCreds)
  const listener = (messages: object[]) => client.receive(messages)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sock.ev.on('messages.upsert', async (payload: any) => {
    const messages = await Promise.all(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload.messages.map(async (m: any) => {
        const { key } = m
        if (!isIndividualJid(key.remoteJid)) {
          m.groupMetadata = await dataStore.fetchGroupMetadata(key.remoteJid, sock)
        }
        return m
      }),
    )
    listener(messages)
  })
  sock.ev.on('messages.update', listener)
  sock.ev.on('message-receipt.update', listener)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sock.ev.on('messages.delete', (update: any) => {
    const keys = update.keys || []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = keys.map((key: any) => {
      return { key, update: { status: 'DELETED' } }
    })
    listener(payload)
  })
  return new Promise<Connection>((resolve, reject) => {
    return sock.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect } = update
      if (connection === 'close' && lastDisconnect) {
        const shouldReconnect = (lastDisconnect.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut
        console.log('connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect)
        // reconnect if not logged out
        if (shouldReconnect) {
          return connect({ store, client })
        }
      } else if (connection === 'open') {
        const message = `Connnected!`
        await client.sendStatus(message)
        const connection: Connection = {
          sock: sock,
          dataStore: dataStore,
        }
        return resolve(connection)
      } else if (update.qr) {
        if (!(await onQrCode(client, update.qr))) {
          const events = ['messages.delete', 'message-receipt.update', 'messages.update', 'messages.upsert', 'creds.update', 'connection.update']
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          events.forEach((key: any) => sock?.ev?.removeAllListeners(key))
          await sock?.ws?.close()
          await sock?.logout()
          const message = `The ${max} times of generate qrcode is exceded!`
          await client.sendStatus(message)
          return reject(message)
        }
      } else if (connection === 'connecting') {
        const message = `Connnecting...`
        await client.sendStatus(message)
      } else {
        console.debug('connection.update', update)
      }
    })
  })
}