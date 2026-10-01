import { forwardRef, type ButtonHTMLAttributes, type ComponentProps } from "react";
import { ActionIcon } from "./ActionIcon.tsx";
import "./icon-button.css";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  label: string;
  icon: ComponentProps<typeof ActionIcon>["name"];
};

/** Compact actions keep their purpose available to keyboard and screen readers. */
export const IconButton = forwardRef<HTMLButtonElement, Props>(function IconButton(
  { label, icon, className, title, type = "button", ...props }, ref,
) {
  return <button {...props} ref={ref} type={type} className={["jz-icon-action", className].filter(Boolean).join(" ")}
    aria-label={props["aria-label"] ?? label} title={title ?? label}><ActionIcon name={icon} /></button>;
});
