import type { AnyFunction } from './type'
import { Logger } from './logger' // 假设你有一个日志模块

const logger = Logger.getLogger(import.meta.filename)

type MethodDecorator<T extends AnyFunction> = (target: T, context: ClassMethodDecoratorContext) => T

/**
 * 同步方法执行时间装饰器
 * @param additionalText 额外的日志文本
 */
export function timeExecutionSync<T extends AnyFunction>(additionalText: string = ''): MethodDecorator<T> {
  return function (
    originalMethod: T,
    context: ClassMethodDecoratorContext,
  ): T {
    // 确保是方法装饰器
    if (context.kind !== 'method') {
      throw new Error('timeExecutionSync 只能用于方法')
    }

    function replacementMethod(this: any, ...args: any[]) {
      const startTime = Date.now()
      const result = originalMethod.apply(this, args)
      const executionTime = (Date.now() - startTime)

      logger.debug(`${additionalText} Execution time: ${executionTime.toFixed(2)} ms`)

      return result
    }

    return replacementMethod as T
  }
}

export function timeExecutionAsync(additionalText: string = '') {
  return function (
    originalMethod: AnyFunction,
    context: ClassMethodDecoratorContext,
  ) {
    // 确保只用于方法
    if (context.kind !== 'method') {
      throw new Error('timeExecutionAsync 只能用于方法')
    }

    // 返回新的异步方法实现
    return async function (this: any, ...args: any[]) {
      const startTime = performance.now()

      // 执行原方法
      const result = await originalMethod.apply(this, args)

      // 计算执行时间并记录日志
      const executionTime = (performance.now() - startTime) / 1000
      logger.debug(`${additionalText} Execution time: ${executionTime.toFixed(2)} seconds`)

      return result
    }
  }
}

export function checkEnvVariables(
  keys: string[],
  anyOrAll: 'any' | 'all' = 'all',
): boolean {
  if (anyOrAll === 'any') {
    return keys.some(key => (process.env[key] || '').trim() !== '')
  } else {
    return keys.every(key => (process.env[key] || '').trim() !== '')
  }
}
