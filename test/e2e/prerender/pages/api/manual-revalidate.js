export default function handler(req, res) {
  res.setManualRevalidate()

  // WARNING: don't use user input in production
  // make sure to use trusted value for redirecting
  res.setHeader('Location', req.query.pathname)
  res.statusCode = 307
  res.end('redirecting')
}
