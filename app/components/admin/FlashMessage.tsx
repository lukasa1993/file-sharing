type FlashMessageProps = {
  message: string
}

export function FlashMessage({ message }: FlashMessageProps) {
  return (
    <p
      data-flash-message
      role="status"
      className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm font-medium text-emerald-100 shadow-inner shadow-emerald-500/20"
    >
      {message}
    </p>
  )
}
