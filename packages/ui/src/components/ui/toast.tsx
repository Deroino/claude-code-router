import { useEffect } from 'react';
import { CheckCircle, XCircle, AlertCircle, X } from 'lucide-react';

interface ToastProps {
  message: string;
  type: 'success' | 'error' | 'warning';
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
      default:
        return 'bg-gray-100 border-gray-200';
    }
  };

  return (
    <div className={`pointer-events-auto flex items-center justify-between p-4 rounded-lg border shadow-lg ${getBackgroundColor()} transition-all duration-300 ease-in-out max-w-[80vw] md:max-w-lg break-words whitespace-normal`}>
      <div className="flex items-center space-x-2">
        {getIcon()}
        <span className="text-sm font-medium">{message}</span>
      </div>
      <button
        onClick={onClose}
        className="ml-4 text-gray-500 hover:text-gray-700 focus:outline-none"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}