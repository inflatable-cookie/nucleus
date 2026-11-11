/** Bound a read without treating a timeout as evidence that the target is absent. */
export async function observationTimeout<T>(work: Promise<T>, message: string, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref();
    })]);
  } finally { clearTimeout(timer); }
}
