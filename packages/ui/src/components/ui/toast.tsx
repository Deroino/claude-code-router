import { useEffect, useRef, useState } from 'react';
import { CheckCircle, XCircle, AlertCircle, Info, X } from 'lucide-react';

interface ToastProps {
  message: string;
  type: 'success' | 'error' | 'warning' | 'info';
  duration?: number;
  /**
   * When set to true by the parent (e.g. evicted because the stack exceeded
   * the visible cap), the toast will play the same exit animation and then
   * call `onClose` to actually remove itself.
   */
  exiting?: boolean;
  onClose: () => void;
}

// Keep this in sync with the Tailwind `duration-300` below.
const EXIT_ANIMATION_MS = 300;

export function Toast({
  message,
  type,
  duration = 2000,
  exiting = false,
  onClose,
}: ToastProps) {
  // Drives the enter animation: render once with `mounted=false` so the toast
  // starts off-screen, then flip to true on the next frame so the transition
  // plays.
  const [mounted, setMounted] = useState(false);
  // Drives the exit animation. Triggered by: auto-close timer, X button click,
  // or the parent setting `exiting=true` (eviction).
  const [isExiting, setIsExiting] = useState(false);

  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Trigger the enter animation on next frame.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Auto-close after `duration` ms (0 disables auto-close).
  useEffect(() => {
    if (duration <= 0) return;
    const timer = setTimeout(() => setIsExiting(true), duration);
    return () => clearTimeout(timer);
  }, [duration]);

  // External force-exit (parent eviction).
  useEffect(() => {
    if (exiting) setIsExiting(true);
  }, [exiting]);

  // Once the exit animation is in progress, schedule the actual unmount.
  useEffect(() => {
    if (!isExiting) return;
    if (closeTimerRef.current) return;
    closeTimerRef.current = setTimeout(() => {
      onClose();
    }, EXIT_ANIMATION_MS);
    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, [isExiting, onClose]);

  const getIcon = () => {
    switch (type) {
      case 'success':
        return <CheckCircle className="h-5 w-5 text-green-500" />;
      case 'error':
        return <XCircle className="h-5 w-5 text-red-500" />;
      case 'warning':
        return <AlertCircle className="h-5 w-5 text-yellow-500" />;
      case 'info':
        return <Info className="h-5 w-5 text-blue-500" />;
      default:
        return null;
    }
  };

  const getBackgroundColor = () => {
    switch (type) {
      case 'success':
        return 'bg-green-100 border-green-200';
      case 'error':
        return 'bg-red-100 border-red-200';
      case 'warning':
        return 'bg-yellow-100 border-yellow-200';
      case 'info':
        return 'bg-blue-100 border-blue-200';
      default:
        return 'bg-gray-100 border-gray-200';
    }
  };

  // Visible state: slide-in from the right + fade-in.
  // Hidden / exiting state: slide-out to the right + fade-out.
  const animationClass =
    mounted && !isExiting
      ? 'translate-x-0 opacity-100'
      : 'translate-x-full opacity-0';

  return (
    <div
      className={`pointer-events-auto flex items-start justify-between gap-3 p-4 rounded-lg border shadow-lg ${getBackgroundColor()} transform transition-all duration-300 ease-out will-change-transform ${animationClass} max-w-[90vw] md:max-w-xl max-h-[40vh] overflow-hidden`}
    >
      <div className="flex items-start gap-2 min-w-0 flex-1 overflow-y-auto overflow-x-hidden pr-2 custom-scrollbar">
        <div className="flex-shrink-0 mt-0.5 sticky top-0">{getIcon()}</div>
        <span className="text-sm font-medium break-words whitespace-pre-wrap overflow-wrap-anywhere min-w-0">
          {message}
        </span>
      </div>
      <button
        onClick={() => setIsExiting(true)}
        className="flex-shrink-0 text-gray-500 hover:text-gray-700 focus:outline-none transition-colors sticky top-0"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
