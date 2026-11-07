import { defineConfig, drivers } from '@adonisjs/core/encryption'

const encryptionConfig = defineConfig({
  default: 'gcm',
  list: {
    gcm: drivers.aes256gcm({
      // The fixture encrypts nothing; AdonisJS needs a key to boot.
      keys: ['fixture-key-that-guards-nothing!'],
      id: 'gcm',
    }),
  },
})

export default encryptionConfig

declare module '@adonisjs/core/types' {
  export interface EncryptorsList extends InferEncryptors<typeof encryptionConfig> {}
}
