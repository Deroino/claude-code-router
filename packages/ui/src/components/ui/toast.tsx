import { useEffect } from 'react';
import { CheckCircle, XCircle, AlertCircle, Info, X } from 'lucide-react';

interface ToastProps {
  message: string;
  type: 'success' | 'error' | 'warning' | 'info';
  duration?: number;
  onClose: () => void;
}

export function Toast({ message, type, duration = 3000, onClose }: ToastProps) {
  useEffect(() => {
    if (duration > 0) {
      const timer = setTimeout(() => {
        onClose();
      }, duration);

      return () => clearTimeout(timer);
    }
  }, [onClose, duration]);

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

  return (
    <div className={`pointer-events-auto flex items-start justify-between gap-3 p-4 rounded-lg border shadow-lg ${getBackgroundColor()} transition-all duration-300 ease-in-out max-w-[90vw] md:max-w-xl max-h-[40vh] overflow-hidden`}>
      <div className="flex items-start gap-2 min-w-0 flex-1 overflow-y-auto overflow-x-hidden pr-2 custom-scrollbar">
        <div className="flex-shrink-0 mt-0.5 sticky top-0">
          {getIcon()}
        </div>
        <span className="text-sm font-medium break-words whitespace-pre-wrap overflow-wrap-anywhere min-w-0">{message}</span>
      </div>
      <button
        onClick={onClose}
        className="flex-shrink-0 text-gray-500 hover:text-gray-700 focus:outline-none transition-colors sticky top-0"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}