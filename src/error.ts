
export class InterruptedError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "InterruptedError";

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, InterruptedError);
    }
  }
}


export class LLMException extends Error {

  public statusCode: number;


  public message: string;


  constructor(statusCode: number, message: string) {

    super(`Error ${statusCode}: ${message}`);


    this.statusCode = statusCode;
    this.message = message;



    this.name = 'LLMException';


    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, LLMException);
    }
  }
}