import { z } from "zod";

/** 图片展示框支持预设比例，也可用正整数宽:高指定设计比例。 */
export const imageAspectSchema = z.union([
  z.enum(["square", "portrait", "landscape"]),
  z
    .string()
    .trim()
    .regex(/^[1-9]\d{0,3}:[1-9]\d{0,3}$/, "图片比例应为预设名称或宽:高，宽高须为 1–9999 的整数")
    .transform((value) => value as `${number}:${number}`),
]);

export type ImageAspect = z.infer<typeof imageAspectSchema>;

/** 用于 CSS aspect-ratio；自定义值已经由布局 Schema 验证。 */
export function imageAspectRatio(aspect: ImageAspect): string {
  if (aspect === "square") return "1 / 1";
  if (aspect === "portrait") return "4 / 5";
  if (aspect === "landscape") return "3 / 2";
  return aspect.replace(":", " / ");
}
