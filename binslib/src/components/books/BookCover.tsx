"use client";

import Image from "next/image";
import { useState } from "react";

const SIZES = {
  xs: { width: 40, height: 55, className: "w-10 h-[55px]" },
  sm: { width: 64, height: 88, className: "w-16 h-[88px]" },
  md: { width: 120, height: 166, className: "w-[120px] h-[166px]" },
  lg: { width: 180, height: 250, className: "w-[180px] h-[250px]" },
};

interface BookCoverProps {
  bookId: number;
  name: string;
  size?: "xs" | "sm" | "md" | "lg";
}

export function BookCover({ bookId, name, size = "md" }: BookCoverProps) {
  const [error, setError] = useState(false);
  const { width, height, className } = SIZES[size];
  const src = error ? "/covers/placeholder.jpg" : `/covers/${bookId}.jpg`;

  return (
    <div className={`${className} relative rounded overflow-hidden bg-gray-100 shrink-0 transition-transform duration-200 group-hover:scale-105`}>
      <Image
        src={src}
        alt={name}
        width={width}
        height={height}
        className="object-cover w-full h-full"
        onError={() => setError(true)}
        unoptimized
      />
    </div>
  );
}
