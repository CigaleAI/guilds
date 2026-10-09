import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** tailwind-merge taught the guilds.run scales, so `text-md` merges as a size and `type-*` as one text style. */
const twMerge = extendTailwindMerge<"type-style">({
  extend: {
    theme: {
      text: ["2xs", "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl"],
      radius: ["2xs", "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "full"],
      shadow: ["pop", "float", "modal"],
    },
    classGroups: {
      "type-style": [
        {
          type: [
            "display",
            "hero",
            "h1",
            "h2",
            "title",
            "body",
            "caption",
            "label",
            "code",
            "meta",
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
