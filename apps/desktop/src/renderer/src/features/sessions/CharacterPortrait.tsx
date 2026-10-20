import { cn } from "cn";
import { useState } from "react";

import { useDocumentImage } from "../modules/document-image";

/** 角色方形头像；无图或加载失败时显示名字首字。 */
export function CharacterPortrait({
  name,
  image,
  path,
  className,
}: {
  name: string;
  image?: string;
  path?: string | null;
  className?: string;
}) {
  const [failed, setFailed] = useState<string>();
  const src = useDocumentImage(path, image);
  return (
    <span
      className={cn(
        "bg-muted from-foreground/12 to-foreground/4 text-muted-foreground flex shrink-0 items-center justify-center overflow-hidden bg-gradient-to-br font-semibold select-none",
        className,
      )}
    >
      {src && failed !== src ? (
        <img
          src={src}
          alt=""
          draggable={false}
          className="size-full object-cover"
          onError={() => setFailed(src)}
        />
      ) : (
        <span aria-hidden="true">{Array.from(name.trim())[0] ?? "?"}</span>
      )}
    </span>
  );
}
