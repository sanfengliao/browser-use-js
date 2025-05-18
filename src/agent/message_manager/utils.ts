import { AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import fs from 'fs';
import path from 'path';
import { AgentOutput } from '../views';


/**
 * List of regex patterns for models that don't support tool calling
 */
export const MODELS_WITHOUT_TOOL_SUPPORT_PATTERNS = [
  'deepseek-reasoner',
  'deepseek-r1',
  '.*gemma.*-it',
];

/**
 * Check if a model name matches any pattern indicating lack of tool support
 * 
 * @param modelName The model name to check
 * @returns True if the model doesn't support tools
 */
export function isModelWithoutToolSupport(modelName: string): boolean {
  return MODELS_WITHOUT_TOOL_SUPPORT_PATTERNS.some(pattern => {
    const regex = new RegExp(pattern);
    return regex.test(modelName);
  });
}

/**
 * Extract JSON from model output, handling both plain JSON and code-block-wrapped JSON.
 * 
 * @param content String content potentially containing JSON
 * @returns Parsed JSON object
 */
export function extractJsonFromModelOutput(content: string): Record<string, any> {
  try {
    // If content is wrapped in code blocks, extract just the JSON part
    if (content.includes('```')) {
      // Find the JSON content between code blocks
      const parts = content.split('```');
      content = parts[1];
      // Remove language identifier if present (e.g., 'json\n')
      if (content.includes('\n')) {
        content = content.split('\n', 2)[1];
      }
    }

    // Parse the cleaned content
    const resultDict = JSON.parse(content);

    // some models occasionally respond with a list containing one dict: https://github.com/browser-use/browser-use/issues/1458
    if (Array.isArray(resultDict) && resultDict.length === 1 && typeof resultDict[0] === 'object' && resultDict[0]) {
      return resultDict[0];
    }

    if (typeof resultDict !== 'object' || resultDict === null) {
      throw new Error(`Expected JSON dictionary in response, got JSON ${typeof resultDict} instead`);
    }

    return resultDict;
  } catch (e) {
    if (e instanceof SyntaxError) {
      console.warn(`Failed to parse model output: ${content} ${e.toString()}`);
      throw new Error('Could not parse response.');
    }
    throw e;
  }
}

/**
 * Convert input messages to a format that is compatible with the planner model
 * 
 * @param inputMessages Original message list
 * @param modelName Optional model name to adapt messages for
 * @returns Converted message list
 */
export function convertInputMessages(inputMessages: BaseMessage[], modelName?: string): BaseMessage[] {
  if (!modelName) {
    return inputMessages;
  }

  if (isModelWithoutToolSupport(modelName)) {
    const convertedInputMessages = convertMessagesForNonFunctionCallingModels(inputMessages);
    let mergedInputMessages = mergeSuccessiveMessages(convertedInputMessages, HumanMessage);
    mergedInputMessages = mergeSuccessiveMessages(mergedInputMessages, AIMessage);
    return mergedInputMessages;
  }

  return inputMessages;
}

/**
 * Convert messages for non-function-calling models
 * 
 * @param inputMessages Original message list
 * @returns Converted message list
 */
function convertMessagesForNonFunctionCallingModels(inputMessages: BaseMessage[]): BaseMessage[] {
  const outputMessages: BaseMessage[] = [];

  for (const message of inputMessages) {
    if (message instanceof HumanMessage || message instanceof SystemMessage) {
      outputMessages.push(message);
    } else if (message instanceof ToolMessage) {
      outputMessages.push(new HumanMessage({
        content: message.content
      }));
    } else if (message instanceof AIMessage) {
      // check if tool_calls is a valid JSON object
      if (message.tool_calls) {
        const toolCalls = JSON.stringify(message.tool_calls);
        outputMessages.push(new AIMessage({
          content: toolCalls
        }));
      } else {
        outputMessages.push(message);
      }
    } else {
      throw new Error(`Unknown message type: ${message.constructor.name}`);
    }
  }

  return outputMessages;
}

/**
 * Some models like deepseek-reasoner dont allow multiple human messages in a row. 
 * This function merges them into one.
 * 
 * @param messages List of messages to process
 * @param ClassToMerge Message class type to merge consecutive instances of
 * @returns Messages with consecutive instances merged
 */
function mergeSuccessiveMessages(messages: BaseMessage[], ClassToMerge: typeof BaseMessage): BaseMessage[] {
  const mergedMessages: BaseMessage[] = [];
  let streak = 0;

  for (const message of messages) {
    if (message instanceof ClassToMerge) {
      streak += 1;
      if (streak > 1) {
        if (Array.isArray(message.content)) {
          // Handle multimodal content
          const lastMessage = mergedMessages[mergedMessages.length - 1];
          if (typeof lastMessage.content === 'string' && typeof message.content[0] === 'object' && 'text' in message.content[0]) {
            lastMessage.content += message.content[0].text;
          }
        } else if (typeof message.content === 'string') {
          // Handle string content
          const lastMessage = mergedMessages[mergedMessages.length - 1];
          if (typeof lastMessage.content === 'string') {
            lastMessage.content += message.content;
          }
        }
      } else {
        mergedMessages.push(message);
      }
    } else {
      mergedMessages.push(message);
      streak = 0;
    }
  }

  return mergedMessages;
}

/**
 * Save conversation history to file.
 * 
 * @param inputMessages List of messages in the conversation
 * @param response The model response
 * @param target File path to save to
 * @param encoding Optional encoding for the file
 */
export function saveConversation(
  {
    inputMessages,
    response,
    target,
    encoding
  }: {
    inputMessages: BaseMessage[],
    response: AgentOutput,
    target: string,
    encoding?: string
  }
): void {
  // create folders if not exists
  const dirname = path.dirname(target);
  if (dirname) {
    fs.mkdirSync(dirname, { recursive: true });
  }

  const options: { encoding?: BufferEncoding } = {};
  if (encoding) {
    options.encoding = encoding as BufferEncoding;
  }

  const fileStream = fs.createWriteStream(target, options);

  writeMessagesToFile(fileStream, inputMessages);
  writeResponseToFile(fileStream, response);

  fileStream.close();
}

/**
 * Write messages to conversation file
 * 
 * @param f File stream to write to
 * @param messages Messages to write
 */
function writeMessagesToFile(f: fs.WriteStream, messages: BaseMessage[]): void {
  for (const message of messages) {
    f.write(` ${(message.constructor as typeof BaseMessage).lc_name()} \n`);

    if (Array.isArray(message.content)) {
      for (const item of message.content) {
        if (typeof item === 'object' && item !== null && item.type === 'text') {
          f.write(item.text.trim() + '\n');
        }
      }
    } else if (typeof message.content === 'string') {
      try {
        const content = JSON.parse(message.content);
        f.write(JSON.stringify(content, null, 2) + '\n');
      } catch (e) {
        f.write(message.content.trim() + '\n');
      }
    }

    f.write('\n');
  }
}

/**
 * Write model response to conversation file
 * 
 * @param f File stream to write to
 * @param response Response to write
 */
function writeResponseToFile(f: fs.WriteStream, response: AgentOutput): void {
  f.write(' RESPONSE\n');
  // Format JSON string with indentation
  f.write(JSON.stringify(response, null, 2));
}