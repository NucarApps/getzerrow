"use client";

/**
 * Dialog on desktop, vaul bottom drawer on phones. One component tree works
 * for both: the root sets a context flag from `useIsMobile`, and every
 * `ResponsiveDialog*` piece renders its Dialog or Drawer counterpart.
 * Only mount these post-hydration (open via user action) — the hook's
 * first-render value is not SSR-safe.
 */
import * as React from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";

const MobileContext = React.createContext(false);

type RootProps = {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
};

export function ResponsiveDialog({ open, onOpenChange, children }: RootProps) {
  const isMobile = useIsMobile();
  if (isMobile) {
    return (
      <MobileContext.Provider value={true}>
        <Drawer open={open} onOpenChange={onOpenChange}>
          {children}
        </Drawer>
      </MobileContext.Provider>
    );
  }
  return (
    <MobileContext.Provider value={false}>
      <Dialog open={open} onOpenChange={onOpenChange}>
        {children}
      </Dialog>
    </MobileContext.Provider>
  );
}

export function ResponsiveDialogContent({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const isMobile = React.useContext(MobileContext);
  if (isMobile) {
    return (
      <DrawerContent {...props}>
        <div className="max-h-[85dvh] overflow-y-auto px-4 pb-6 pt-2">{children}</div>
      </DrawerContent>
    );
  }
  return (
    <DialogContent className={cn("max-h-[90dvh] overflow-y-auto", className)} {...props}>
      {children}
    </DialogContent>
  );
}

export function ResponsiveDialogHeader(props: React.HTMLAttributes<HTMLDivElement>) {
  const isMobile = React.useContext(MobileContext);
  return isMobile ? <DrawerHeader className="px-0" {...props} /> : <DialogHeader {...props} />;
}

export function ResponsiveDialogTitle(props: React.ComponentPropsWithoutRef<typeof DialogTitle>) {
  const isMobile = React.useContext(MobileContext);
  return isMobile ? <DrawerTitle {...props} /> : <DialogTitle {...props} />;
}

export function ResponsiveDialogDescription(
  props: React.ComponentPropsWithoutRef<typeof DialogDescription>,
) {
  const isMobile = React.useContext(MobileContext);
  return isMobile ? <DrawerDescription {...props} /> : <DialogDescription {...props} />;
}

export function ResponsiveDialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const isMobile = React.useContext(MobileContext);
  return isMobile ? (
    <DrawerFooter className={cn("px-0", className)} {...props} />
  ) : (
    <DialogFooter className={className} {...props} />
  );
}
