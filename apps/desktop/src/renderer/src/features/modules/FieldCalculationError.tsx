/** 错误和合法空值采用不同状态，具体诊断按需展开。 */
export function FieldCalculationError({ error }: { readonly error: string }) {
  return (
    <details role="alert" className="text-destructive text-sm">
      <summary className="cursor-default">计算失败</summary>
      <p className="mt-1 text-xs leading-5 [overflow-wrap:anywhere] whitespace-pre-wrap">{error}</p>
    </details>
  );
}
