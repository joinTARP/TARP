import { Field as FieldPrimitive } from "@base-ui/react/field";
import { Form as FormPrimitive } from "@base-ui/react/form";
import { cn } from "cn";

// Base UI 禁用浏览器校验气泡，提交时聚焦首个错误，之后随输入重新校验。
export const Form = FormPrimitive;
export const Field = FieldPrimitive.Root;
export function FieldLabel({ className, ...props }: FieldPrimitive.Label.Props) {
  return <FieldPrimitive.Label className={cn("block", className)} {...props} />;
}

export function FieldDescription({ className, ...props }: FieldPrimitive.Description.Props) {
  return (
    <FieldPrimitive.Description
      className={cn("text-muted-foreground block text-xs leading-5", className)}
      {...props}
    />
  );
}

export function FieldError({ className, ...props }: FieldPrimitive.Error.Props) {
  return (
    <FieldPrimitive.Error
      role="alert"
      className={cn("text-destructive text-xs leading-5", className)}
      {...props}
    />
  );
}
