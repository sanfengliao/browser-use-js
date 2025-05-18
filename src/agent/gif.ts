import { AgentHistoryList } from './views'

interface CreateHistoryGifParams {
  task: string
  history: AgentHistoryList
  outputPath?: string
  duration?: number
  showGoals?: boolean
  showTask?: boolean
  showLogo?: boolean
  fontSize?: number
  titleFontSize?: number
  goalFontSize?: number
  margin?: number
  lineSpacing?: number
}

export function createHistoryGif({ task, history, outputPath = 'agent_history.gif', duration = 3000, showGoals = true, showTask = true, showLogo = true, fontSize = 40, titleFontSize = 56, goalFontSize = 44, margin = 40, lineSpacing = 1.5 }: CreateHistoryGifParams) {
  throw new Error('Function not implemented.')
}
