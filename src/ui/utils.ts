export function truncateEnd(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  if (maxLength <= 3) return value.slice(0, maxLength)
  return `${value.slice(0, maxLength - 3)}...`
}

export function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  if (maxLength <= 1) return value.slice(0, maxLength)
  const keep = maxLength - 1
  const left = Math.ceil(keep / 2)
  const right = Math.floor(keep / 2)
  return `${value.slice(0, left)}…${value.slice(value.length - right)}`
}
