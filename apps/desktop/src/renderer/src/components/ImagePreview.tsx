import { Dialog } from "@base-ui/react/dialog";
import { cn } from "cn";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { PhotoSlider } from "react-photo-view";

import "react-photo-view/dist/react-photo-view.css";

interface PreviewImage {
  readonly key: string;
  readonly src: string;
  readonly alt: string;
  readonly originRef: RefObject<HTMLButtonElement | null>;
}

interface ImagePreviewGroup {
  readonly images: PreviewImage[];
  readonly register: (image: PreviewImage) => void;
  readonly remove: (key: string) => void;
}

export const ImagePreviewContext = createContext<ImagePreviewGroup | null>(null);

/** 同一组内的图片可以连续切换；单独使用 ImagePreview 时自动建立一组。 */
export function ImagePreviewProvider({ children }: { readonly children: ReactNode }) {
  const [images, setImages] = useState<PreviewImage[]>([]);
  const register = useCallback((image: PreviewImage) => {
    setImages((current) => {
      const existing = current.find((item) => item.key === image.key);
      if (!existing) return [...current, image];
      if (existing.src === image.src && existing.alt === image.alt) return current;
      return current.map((item) => (item.key === image.key ? image : item));
    });
  }, []);
  const remove = useCallback((key: string) => {
    setImages((current) => current.filter((image) => image.key !== key));
  }, []);
  const group = useMemo(() => ({ images, register, remove }), [images, register, remove]);
  return <ImagePreviewContext.Provider value={group}>{children}</ImagePreviewContext.Provider>;
}

interface ImagePreviewProps {
  readonly src: string;
  readonly alt: string;
  readonly className?: string;
  /** 自定义缩略图，例如带加载状态的图片。内容应为非交互元素。 */
  readonly children?: ReactNode;
}

export function ImagePreview(props: ImagePreviewProps) {
  const group = useContext(ImagePreviewContext);
  return group ? (
    <ImagePreviewContent {...props} group={group} />
  ) : (
    <ImagePreviewProvider>
      <ImagePreview {...props} />
    </ImagePreviewProvider>
  );
}

function ImagePreviewContent({
  src,
  alt,
  className,
  children,
  group: { images, register, remove },
}: ImagePreviewProps & { readonly group: ImagePreviewGroup }) {
  const id = useId();
  const originRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<Dialog.Root.Actions>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState(id);
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);
  const setPopup = useCallback((element: HTMLDivElement | null) => {
    popupRef.current = element;
    setPortalContainer(element);
  }, []);

  useEffect(() => {
    register({ key: id, src, alt, originRef });
  }, [id, src, alt, register]);
  useEffect(() => () => remove(id), [id, remove]);

  const index = Math.max(
    0,
    images.findIndex((image) => image.key === selectedKey),
  );
  const selected = images[index];
  const changeIndex = (nextIndex: number) => {
    const image = images[(nextIndex + images.length) % images.length];
    if (image) setSelectedKey(image.key);
  };

  return (
    // 预览弹窗随触发图片放置，文档弹窗内的图片因此使用独立的嵌套弹层。
    <Dialog.Root
      open={open}
      actionsRef={actionsRef}
      onOpenChange={(nextOpen, details) => {
        setOpen(nextOpen);
        if (nextOpen) setSelectedKey(id);
        else details.preventUnmountOnClose();
      }}
    >
      <Dialog.Trigger
        ref={originRef}
        aria-label={`放大查看${alt || "图片"}`}
        className={cn(
          "focus-visible:outline-ring block max-w-full cursor-zoom-in rounded-[inherit] focus-visible:outline-2 focus-visible:outline-offset-2",
          className,
        )}
      >
        {children ?? <img src={src} alt={alt} className="block max-w-full" />}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Popup
          ref={setPopup}
          initialFocus={popupRef}
          className="fixed inset-0 isolate z-[2000] outline-none"
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              event.stopPropagation();
              changeIndex(index + (event.key === "ArrowLeft" ? -1 : 1));
            }
          }}
        >
          <Dialog.Title className="sr-only">{selected?.alt || "图片预览"}</Dialog.Title>
          {portalContainer ? (
            <PhotoSlider
              images={images}
              index={index}
              visible={open}
              onIndexChange={changeIndex}
              onClose={() => actionsRef.current?.close()}
              afterClose={() => actionsRef.current?.unmount()}
              portalContainer={portalContainer}
              loop
              maskOpacity={0.92}
              bannerVisible={false}
              className="z-0!"
              photoWrapClassName="[clip-path:inset(3rem_0_0)]"
              photoClassName="box-border object-contain! px-6 pt-20 pb-8 sm:px-12"
            />
          ) : null}
          <div className="absolute inset-x-0 top-0 z-10 flex h-12 items-center justify-between gap-4 bg-black/90 px-4 text-sm text-white">
            <span className="min-w-0 truncate" aria-live="polite">
              {selected?.alt || "图片预览"}
              {images.length > 1 ? ` · ${index + 1} / ${images.length}` : ""}
            </span>
            <Dialog.Close
              aria-label="关闭图片预览"
              className="flex size-10 shrink-0 items-center justify-center rounded-md outline-none hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <X className="size-5" aria-hidden="true" />
            </Dialog.Close>
          </div>
          {images.length > 1 ? (
            <>
              <button
                type="button"
                aria-label="上一张图片"
                onClick={() => changeIndex(index - 1)}
                className="absolute top-1/2 left-4 z-10 -translate-y-1/2 rounded-md bg-black/30 p-3 text-white outline-none hover:bg-black/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                <ChevronLeft className="size-6" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="下一张图片"
                onClick={() => changeIndex(index + 1)}
                className="absolute top-1/2 right-4 z-10 -translate-y-1/2 rounded-md bg-black/30 p-3 text-white outline-none hover:bg-black/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                <ChevronRight className="size-6" aria-hidden="true" />
              </button>
            </>
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
