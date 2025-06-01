import { z } from 'zod'
import zodToJsonSchema from 'zod-to-json-schema'
import { SignalHandler } from './utils'

console.log(AbortController, AbortSignal)

async function main1() {
  const schema = z.object({
    name: z.string(),
  })
  console.log(schema.shape, zodToJsonSchema(schema))
}

main1()
