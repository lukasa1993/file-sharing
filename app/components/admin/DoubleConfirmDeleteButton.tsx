import { dangerButtonClass, secondaryButtonClass } from '../ui.ts'

let instanceCounter = 0

function nextInstanceId(): string {
  instanceCounter += 1
  return `double-confirm-${instanceCounter}`
}

type DoubleConfirmDeleteButtonProps = {
  itemKind: 'file' | 'folder'
  itemLabel: string
  triggerLabel?: string
}

export function DoubleConfirmDeleteButton({
  itemKind,
  itemLabel,
  triggerLabel = 'Delete',
}: DoubleConfirmDeleteButtonProps) {
  let instanceId = nextInstanceId()
  let overlayId = `${instanceId}-overlay`
  let titleId = `${instanceId}-title`
  let descriptionId = `${instanceId}-description`
  let finalMessageId = `${instanceId}-final`

  return (
    <div data-double-confirm-root className="relative inline-flex">
      <button
        type="button"
        data-double-confirm-trigger
        data-dialog={overlayId}
        aria-haspopup="dialog"
        aria-controls={overlayId}
        aria-expanded="false"
        className={`${dangerButtonClass} px-3 py-1.5 text-xs font-semibold`}
      >
        {triggerLabel}
      </button>
      <div
        id={overlayId}
        data-double-confirm-overlay
        className="fixed inset-0 z-40 hidden flex items-center justify-center bg-slate-950/70 px-4 py-10 backdrop-blur-sm"
        aria-hidden="true"
      >
        <div
          data-double-confirm-container
          data-stage="first"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={`${descriptionId} ${finalMessageId}`}
          className="group/dc w-full max-w-sm rounded-2xl border border-rose-500/40 bg-slate-950/95 p-6 text-left text-sm text-slate-200 shadow-2xl shadow-rose-900/40 transition-transform duration-200 ease-out data-[stage=second]:-translate-y-4 data-[stage=second]:translate-x-16 sm:data-[stage=second]:translate-x-24"
        >
          <div className="space-y-3">
            <p id={titleId} className="text-xs font-semibold uppercase tracking-wide text-rose-200">
              Confirm deletion
            </p>
            <p
              id={descriptionId}
              className="leading-relaxed text-slate-200 group-data-[stage=second]/dc:hidden"
            >
              Remove the {itemKind === 'folder' ? 'folder' : 'file'}{' '}
              <span className="font-semibold text-white">{itemLabel}</span>?
            </p>
            <p
              id={finalMessageId}
              className="hidden text-xs font-semibold uppercase tracking-wide text-rose-300 group-data-[stage=second]/dc:block"
            >
              Final check: this delete cannot be reversed.
            </p>
            <p className="text-xs text-slate-400">
              This action permanently removes the {itemKind === 'folder' ? 'folder' : 'file'} and
              its contents.
            </p>
          </div>

          <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between group-data-[stage=second]/dc:hidden">
            <button
              type="button"
              data-double-confirm-cancel
              className={`${secondaryButtonClass} px-3 py-1.5 text-xs font-semibold uppercase tracking-wide`}
            >
              Keep it
            </button>
            <button
              type="button"
              data-double-confirm-advance
              className={`${dangerButtonClass} self-end px-3 py-1.5 text-xs font-semibold uppercase tracking-wide sm:self-end`}
            >
              Confirm once
            </button>
          </div>

          <div className="mt-5 hidden flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3 group-data-[stage=second]/dc:flex">
            <button
              type="button"
              data-double-confirm-back
              className={`${secondaryButtonClass} px-3 py-1.5 text-xs font-semibold uppercase tracking-wide`}
            >
              Back
            </button>
            <button
              type="submit"
              data-double-confirm-final
              className={`${dangerButtonClass} self-start px-3 py-1.5 text-xs font-semibold uppercase tracking-wide`}
            >
              Final confirm
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
