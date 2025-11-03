type FlashMessageProps = {
  message: string
}

export function FlashMessage({ message }: FlashMessageProps) {
  return <p>{message}</p>
}
