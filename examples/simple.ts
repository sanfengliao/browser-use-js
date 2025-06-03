import { ChatOpenAI } from '@langchain/openai'
import { Agent } from '../src/agent/service'

async function main() {
  const llm = new ChatOpenAI({
    model: 'deepseek-ai/DeepSeek-V3',
    apiKey: process.env.OPENAI_API_KEY || '',
    configuration: {
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    },
  })
  const task = 'Go to kayak.com and find the cheapest one-way flight from Zurich to San Francisco in 3 weeks.'
  const agent = new Agent({
    task,
    llm,
    enableMemory: false,
  })

  agent.run()
}

main()
