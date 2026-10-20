import { imageAspectRatio, type ImageAspect } from "@jointarp/module/image-aspect";
import { cn } from "cn";
import { useState } from "react";

import { ImagePreview } from "../../components/ImagePreview";
import { LoadingIndicator } from "../../components/ui/loading-indicator";
import { useDocumentImage } from "./document-image";

interface DocumentCoverProps {
  readonly src?: string;
  readonly path?: string;
  readonly scope?: string;
  readonly title: string;
  readonly className?: string;
  readonly imageAspect?: ImageAspect;
  readonly preview?: boolean;
}

export function DocumentCover({
  src: image,
  path,
  scope,
  title,
  className,
  imageAspect,
  preview = false,
}: DocumentCoverProps) {
  const src = useDocumentImage(path, image, scope);
  const [result, setResult] = useState<{ src: string | undefined; status: "loaded" | "failed" }>();
  const status = result?.src === src ? result?.status : undefined;
  const showImage = Boolean(src) && status !== "failed";
  const content = (
    <img
      className="size-full object-contain"
      src={src}
      alt={title}
      draggable={false}
      onLoad={() => setResult({ src, status: "loaded" })}
      onError={() => setResult({ src, status: "failed" })}
    />
  );
  return (
    <div
      className={cn("bg-muted relative overflow-hidden", className)}
      style={imageAspect ? { aspectRatio: imageAspectRatio(imageAspect) } : undefined}
    >
      {showImage && status !== "loaded" ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <LoadingIndicator label="正在加载图片…" />
        </div>
      ) : null}
      {showImage ? (
        <div className={imageAspect ? "absolute inset-0" : "size-full"}>
          {preview && src ? (
            <ImagePreview src={src} alt={title} className="size-full">
              {content}
            </ImagePreview>
          ) : (
            content
          )}
        </div>
      ) : (
        <div
          className="from-foreground/12 to-foreground/5 absolute inset-0 bg-gradient-to-br via-transparent"
          aria-hidden="true"
        />
      )}
    </div>
  );
}
