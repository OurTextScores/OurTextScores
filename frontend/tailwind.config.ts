import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: 'class',
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./pages/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        // Custom neutral scale for a richer dark mode
        midnight: {
          50: '#f4f6f8',
          100: '#e4e8ed',
          200: '#cdd5df',
          300: '#aab6c8',
          400: '#8194ad',
          500: '#627694',
          600: '#4b5d7a',
          700: '#3d4b63',
          800: '#343e51',
          900: '#2d3544',
          950: '#0b1120', // Deep obsidian for dark mode bg
        },
        // Vibrant primary accent (Indigo/Violet)
        primary: {
          50: '#f5f3ff',
          100: '#ede9fe',
          200: '#ddd6fe',
          300: '#c4b5fd',
          400: '#a78bfa',
          500: '#8b5cf6',
          600: '#7c3aed',
          700: '#6d28d9',
          800: '#5b21b6',
          900: '#4c1d95',
          950: '#2e1065',
        }
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'Plus Jakarta Sans', 'Inter', 'system-ui', 'sans-serif'],
        heading: ['var(--font-heading)', 'Playfair Display', 'Georgia', 'serif'],
      }
    }
  },
  plugins: []
};

export default config;
