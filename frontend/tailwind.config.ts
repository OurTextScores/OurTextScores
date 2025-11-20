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
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          800: '#1e40af',
          900: '#1e3a8a',
          950: '#172554',
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
