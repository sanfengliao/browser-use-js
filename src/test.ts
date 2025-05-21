import { SignalHandler } from './utils'

let isPaused = false
console.log(AbortController, AbortSignal)

async function main1() {
  const a = [1, 2, 3, 4, 5, 7, 8, 9, 10]
  const signal = new SignalHandler({
    pauseCallback: () => {
      isPaused = true
    },
    resumeCallback: () => {
      isPaused = false
    },
    exitOnSecondInt: true,
  })
  signal.register()
  for (let i = 0; i < a.length; i++) {
    if (isPaused) {
      console.log('Paused')
      await signal.waitForResume()
      signal.reset()
    }
    await new Promise((resolve) => {
      setTimeout(() => {
        console.log('execute', i, a[i])
        resolve(true)
      }, 1000)
    })
  }
}

main1()
