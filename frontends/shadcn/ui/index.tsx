/** shadcn/ui components, as `shadcn add` writes them: Radix primitives styled with Tailwind and the theme's variables. */
import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { cva, type VariantProps } from 'class-variance-authority'
import { clsx, type ClassValue } from 'clsx'
import { Check, Loader2, X } from 'lucide-react'
import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { twMerge } from 'tailwind-merge'

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))

// ---------- button ----------
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
        outline: 'border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: { default: 'h-8 px-3', sm: 'h-7 px-2.5 text-xs', lg: 'h-9 px-4', icon: 'h-8 w-8' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> { loading?: boolean }
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, loading, children, disabled, ...props }, ref) => (
  <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} {...props}>
    {loading && <Loader2 className="animate-spin" />}{children}
  </button>
))

// ---------- badge ----------
const badgeVariants = cva('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none', {
  variants: {
    variant: {
      default: 'border-transparent bg-primary text-primary-foreground',
      secondary: 'border-transparent bg-secondary text-secondary-foreground',
      outline: 'text-foreground',
      ok: 'border-transparent bg-ok/12 text-ok', warn: 'border-transparent bg-warn/12 text-warn',
      info: 'border-transparent bg-info/12 text-info', destructive: 'border-transparent bg-destructive/12 text-destructive',
    },
  },
  defaultVariants: { variant: 'secondary' },
})
export const Badge = ({ className, variant, ...props }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) => <span className={cn(badgeVariants({ variant }), className)} {...props} />

/** A coloured dot and a label: a status. */
export const Status = ({ tone, children }: { tone: 'ok' | 'warn' | 'info' | 'destructive' | 'muted', children: ReactNode }) => (
  <span className="inline-flex items-center gap-1.5 text-xs">
    <span className={cn('size-1.5 rounded-full', { ok: 'bg-ok', warn: 'bg-warn', info: 'bg-info', destructive: 'bg-destructive', muted: 'bg-muted-foreground/50' }[tone])} />{children}
  </span>
)

// ---------- form controls ----------
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn('flex h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50', className)} {...props} />
))
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn('flex min-h-16 w-full rounded-md border border-input bg-transparent px-2.5 py-1.5 font-mono text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring', className)} {...props} />
))
export const NativeSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...props }, ref) => (
  <select ref={ref} className={cn('h-8 rounded-md border border-input bg-transparent px-2 text-[13px] shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring', className)} {...props} />
))
export const Label = ({ className, ...props }: HTMLAttributes<HTMLLabelElement> & { htmlFor?: string }) => <label className={cn('text-xs font-medium leading-none text-muted-foreground', className)} {...props} />

export const Checkbox = ({ checked, onCheckedChange, id }: { checked: boolean, onCheckedChange: (checked: boolean) => void, id?: string }) => (
  <CheckboxPrimitive.Root id={id} checked={checked} onCheckedChange={value => onCheckedChange(value === true)}
    className="peer size-4 shrink-0 rounded-sm border border-primary shadow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground">
    <CheckboxPrimitive.Indicator className="flex items-center justify-center"><Check className="size-3" /></CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
)
export const Switch = ({ checked, onCheckedChange }: { checked: boolean, onCheckedChange: (checked: boolean) => void }) => (
  <SwitchPrimitive.Root checked={checked} onCheckedChange={onCheckedChange}
    className="peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors data-[state=checked]:bg-primary data-[state=unchecked]:bg-input">
    <SwitchPrimitive.Thumb className="pointer-events-none block size-4 rounded-full bg-background shadow-lg transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
  </SwitchPrimitive.Root>
)

// ---------- card ----------
export const Card = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => <div className={cn('rounded-lg border bg-card text-card-foreground shadow-sm', className)} {...props} />
export const CardHeader = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => <div className={cn('flex items-center justify-between gap-3 border-b px-4 py-3', className)} {...props} />
export const CardTitle = ({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) => <h3 className={cn('text-sm font-semibold tracking-tight', className)} {...props} />
export const CardContent = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => <div className={cn('p-4', className)} {...props} />

// ---------- table ----------
export const Table = ({ className, ...props }: HTMLAttributes<HTMLTableElement>) => <table className={cn('w-full caption-bottom text-[13px]', className)} {...props} />
export const THead = (props: HTMLAttributes<HTMLTableSectionElement>) => <thead className="sticky top-0 z-[1] bg-muted/60 backdrop-blur [&_tr]:border-b" {...props} />
export const TBody = (props: HTMLAttributes<HTMLTableSectionElement>) => <tbody className="[&_tr:last-child]:border-0" {...props} />
export const TR = ({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) => <tr className={cn('border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted', className)} {...props} />
export const TH = ({ className, ...props }: HTMLAttributes<HTMLTableCellElement>) => <th className={cn('h-8 px-3 text-left align-middle text-[11px] font-medium uppercase tracking-wide text-muted-foreground', className)} {...props} />
export const TD = ({ className, ...props }: HTMLAttributes<HTMLTableCellElement> & { colSpan?: number }) => <td className={cn('px-3 py-2 align-middle', className)} {...props} />

// ---------- tabs ----------
export const Tabs = TabsPrimitive.Root
export const TabsList = ({ className, ...props }: TabsPrimitive.TabsListProps) => <TabsPrimitive.List className={cn('inline-flex h-9 items-center gap-4 border-b px-4', className)} {...props} />
export const TabsTrigger = ({ className, ...props }: TabsPrimitive.TabsTriggerProps) => (
  <TabsPrimitive.Trigger className={cn('-mb-px inline-flex h-9 items-center gap-1.5 border-b-2 border-transparent text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground [&_svg]:size-3.5', className)} {...props} />
)
export const TabsContent = ({ className, ...props }: TabsPrimitive.TabsContentProps) => <TabsPrimitive.Content className={cn('flex min-h-0 flex-1 flex-col focus-visible:outline-none data-[state=inactive]:hidden', className)} {...props} />

// ---------- dialog ----------
export function Dialog({ open, onOpenChange, title, description, children, footer }: { open: boolean, onOpenChange: (open: boolean) => void, title: string, description?: ReactNode, children?: ReactNode, footer?: ReactNode }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 animate-fade-in" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border bg-background p-5 shadow-lg animate-zoom-in">
          <div className="space-y-1.5">
            <DialogPrimitive.Title className="text-[15px] font-semibold tracking-tight">{title}</DialogPrimitive.Title>
            {description ? <DialogPrimitive.Description className="text-[13px] text-muted-foreground">{description}</DialogPrimitive.Description> : <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>}
          </div>
          {children}
          {footer && <div className="flex justify-end gap-2">{footer}</div>}
          <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-60 transition-opacity hover:opacity-100" aria-label="关闭"><X className="size-4" /></DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

// ---------- dropdown menu ----------
export const Menu = DropdownPrimitive.Root
export const MenuTrigger = DropdownPrimitive.Trigger
export const MenuContent = ({ className, ...props }: DropdownPrimitive.DropdownMenuContentProps) => (
  <DropdownPrimitive.Portal>
    <DropdownPrimitive.Content sideOffset={4} align="end" className={cn('z-50 min-w-44 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md animate-fade-in', className)} {...props} />
  </DropdownPrimitive.Portal>
)
export const MenuItem = ({ className, destructive, ...props }: DropdownPrimitive.DropdownMenuItemProps & { destructive?: boolean }) => (
  <DropdownPrimitive.Item className={cn('relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] outline-none transition-colors focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-3.5', destructive && 'text-destructive focus:text-destructive', className)} {...props} />
)
export const MenuSeparator = () => <DropdownPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />

// ---------- tooltip ----------
export const TooltipProvider = TooltipPrimitive.Provider
export function Tip({ text, children }: { text?: ReactNode, children: ReactNode }) {
  if (!text) return <>{children}</>
  return (
    <TooltipPrimitive.Root delayDuration={300}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content sideOffset={4} className="z-50 max-w-xs rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground animate-fade-in">{text}</TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

/** A row of controls that wraps. */
export const Toolbar = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => <div className={cn('flex flex-wrap items-center gap-2', className)} {...props} />
export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="pointer-events-none inline-flex h-5 select-none items-center rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">{children}</kbd>
