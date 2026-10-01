import { JIZUO_APP_ICON_DATA_URL } from "./appIcon.ts";

export interface JizuoBrandMarkProps {
  size: number;
  className?: string;
}

export function JizuoBrandMark({ size, className }: JizuoBrandMarkProps) {
  return (
    <img
      src={JIZUO_APP_ICON_DATA_URL}
      width={size}
      height={size}
      className={className}
      alt="即作"
      draggable={false}
    />
  );
}
