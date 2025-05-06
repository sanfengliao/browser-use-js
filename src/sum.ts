import { timeExecutionSync } from './utils'

// 使用示例
class ExampleClass {
  @timeExecutionSync('MyMethod')
  doSomething(x: number): number {
    // 模拟一些耗时操作
    let result = 0
    for (let i = 0; i < 1000000; i++) {
      result += x
    }
    return result
  }
}

new ExampleClass().doSomething(5) // 调用方法
