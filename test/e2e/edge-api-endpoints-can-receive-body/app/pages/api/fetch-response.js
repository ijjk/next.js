export const config = {
  runtime: 'experimental-edge',
}

export default async function handler(req) {
  const headers = new Headers(req.headers)
  headers.set('x-custom-header', 'hello')
  console.log(Object.fromEntries(req.headers))

  const res = await fetch('https://example.vercel.sh', {
    method: req.method,
    redirect: 'manual',
    body: req.body,
    headers: headers,
  })

  console.log(res.status)
  console.log(Object.fromEntries(res.headers))
  res.headers.delete('content-encoding')
  res.headers.delete('transfer-encoding')

  return new Response(res.body, {
    status: res.status,
    headers: res.headers,
    statusText: res.statusText,
  })
}
