"use client"

import * as React from "react"
import { Check, ChevronsUpDown } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

interface ComboboxOption {
  label: string;
  value: string;
  status?: 'success' | 'error' | 'neutral';
  successCount?: number;
}

interface ComboboxProps {
  options: ComboboxOption[];
  value?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyPlaceholder?: string;
  hoveredValue?: string;
  onItemHover?: (value: string | null) => void;
}

export function Combobox({
  options,
  value,
  onChange,
  placeholder = "Select an option...",
  searchPlaceholder = "Search...",
  emptyPlaceholder = "No options found.",
  hoveredValue,
  onItemHover,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false)

  const selectedOption = options.find((option) => option.value === value)
  const isHovered = hoveredValue && value === hoveredValue

  // Get status-based background class for dropdown items
  const getStatusClass = (status?: 'success' | 'error' | 'neutral') => {
    switch (status) {
      case 'success':
        return 'bg-green-50 hover:bg-green-100';
      case 'error':
        return 'bg-red-50 hover:bg-red-100';
      default:
        return '';
    }
  };

  // Get status indicator dot color
  const getStatusDotClass = (status?: 'success' | 'error' | 'neutral') => {
    switch (status) {
      case 'success':
        return 'bg-green-500';
      case 'error':
        return 'bg-red-500';
      default:
        return 'bg-gray-300';
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={`w-full justify-between transition-all-ease hover:scale-[1.02] active:scale-[0.98] ${isHovered ? 'ring-2 ring-blue-500 ring-offset-2 bg-blue-50 border-blue-300' : ''}`}
        >
          <span className="flex items-center gap-2 truncate">
            {selectedOption?.status && selectedOption.status !== 'neutral' && (
              <span className={`w-2 h-2 rounded-full shrink-0 ${getStatusDotClass(selectedOption.status)}`} />
            )}
            {selectedOption ? selectedOption.label : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50 transition-transform duration-200 group-data-[state=open]:rotate-180" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0 animate-fade-in">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyPlaceholder}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  onMouseEnter={() => onItemHover?.(option.value)}
                  onMouseLeave={() => onItemHover?.(null)}
                  onSelect={(currentValue) => {
                    onChange(currentValue === value ? "" : currentValue)
                    setOpen(false)
                  }}
                  className={cn(
                    "transition-all-ease",
                    getStatusClass(option.status),
                    hoveredValue === option.value ? "bg-blue-100 border-l-2 border-blue-500" : ""
                  )}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4 transition-opacity shrink-0",
                      value === option.value ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span className="flex items-center gap-2 flex-1 min-w-0">
                    {option.status && option.status !== 'neutral' && (
                      <span className={`w-2 h-2 rounded-full shrink-0 ${getStatusDotClass(option.status)}`} />
                    )}
                    <span className="truncate">{option.label}</span>
                    {option.successCount !== undefined && option.successCount > 0 && (
                      <span className="text-xs text-gray-400 shrink-0">({option.successCount})</span>
                    )}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
