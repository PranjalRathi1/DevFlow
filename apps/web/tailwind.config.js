import colors from "tailwindcss/colors";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f0f5ff",
          100: "#dbe6fe",
          200: "#bcd0fe",
          300: "#8fb0fd",
          400: "#5c87fa",
          500: "#3b63f5",
          600: "#2745e8",
          700: "#2036c9",
          800: "#1f30a2",
          900: "#1f2e80",
          950: "#161c4d",
        },
        // Semantic aliases onto Tailwind's built-in palettes rather than a
        // custom scale — one consistent meaning ("success" = emerald)
        // used everywhere status/priority is rendered, without inventing
        // a parallel color system to maintain.
        success: colors.emerald,
        warning: colors.amber,
        danger: colors.red,
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
