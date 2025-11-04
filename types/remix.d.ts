declare module '@remix-run/dom' {
  interface HTMLInputProps<Target extends EventTarget = HTMLInputElement> {
    webkitdirectory?: boolean
    directory?: boolean
  }
}

export {}
