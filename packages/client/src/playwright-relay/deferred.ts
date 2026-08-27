/** Promise that can be resolved or rejected from outside. */
export function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: Error) => void;
  isDone(): boolean;
} {
  let done = false;
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => {
      done = true;
      res(value);
    };
    reject = (error) => {
      done = true;
      rej(error);
    };
  });
  void promise.catch(() => {});
  return {
    promise,
    resolve,
    reject,
    isDone: () => done,
  };
}
