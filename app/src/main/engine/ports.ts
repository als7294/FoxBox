import { createServer } from 'node:net'

/** Ask the OS for a free TCP port on `host`. */
export function findFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('could not determine a free port'))
      })
    })
  })
}

/** True when nothing is listening on `port` (we can bind it ourselves). */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen(port, host, () => server.close(() => resolve(true)))
  })
}
