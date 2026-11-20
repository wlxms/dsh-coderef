const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 8000)
try {
  const response = await fetch('http://127.0.0.1:9222/json/list', { signal: controller.signal })
  const text = await response.text()
  console.log('OK', response.status, text.length)
} catch (error) {
  console.log('ERR', error.name, error.message)
} finally {
  clearTimeout(timer)
}
process.exit(0)
