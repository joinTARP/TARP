import { NumberField } from "@base-ui/react/number-field";
import { cn } from "cn";
import { Minus, Plus } from "lucide-react";

const numberFormat = { useGrouping: false, maximumFractionDigits: 20 };
const quantityFormat = { useGrouping: false, maximumFractionDigits: 0 };

/** 数值使用 Base UI 管理编辑中间态；滚轮继续滚动页面，不修改字段。 */
export function NumberInput({
  value,
  onValueChange,
  min,
  max,
  step = 1,
  disabled,
  quantity = false,
  className,
  ...props
}: Omit<NumberField.Input.Props, "value" | "onChange" | "min" | "max" | "step"> & {
  value: number | null;
  onValueChange: NonNullable<NumberField.Root.Props["onValueChange"]>;
  min?: number;
  max?: number;
  step?: number | "any";
  quantity?: boolean;
}) {
  const stepClass =
    "grid w-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent focus-visible:outline-1 focus-visible:outline-ring disabled:opacity-40";
  return (
    <NumberField.Root
      id={props.id}
      value={value}
      onValueChange={onValueChange}
      min={min}
      max={max}
      step={step}
      smallStep={step === "any" ? 0.1 : step}
      disabled={disabled}
      allowWheelScrub={false}
      allowOutOfRange={!quantity}
      format={quantity ? quantityFormat : numberFormat}
      className={cn("min-w-0", className)}
    >
      <NumberField.Group className="bg-muted hover:bg-accent/70 focus-within:border-ring has-[[aria-invalid=true]]:border-destructive flex h-9 items-stretch rounded-lg border border-transparent px-1 transition-colors duration-150 motion-reduce:transition-none">
        {quantity ? (
          <NumberField.Decrement className={stepClass} aria-label="减少数量">
            <Minus className="size-3.5" />
          </NumberField.Decrement>
        ) : null}
        <NumberField.Input
          {...props}
          aria-roledescription="数值输入"
          className={cn(
            "w-full min-w-0 bg-transparent px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50",
            quantity && "px-1 text-center",
          )}
        />
        {quantity ? (
          <NumberField.Increment className={stepClass} aria-label="增加数量">
            <Plus className="size-3.5" />
          </NumberField.Increment>
        ) : null}
      </NumberField.Group>
    </NumberField.Root>
  );
}
