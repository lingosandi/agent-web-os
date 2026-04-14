import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

// const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1]
// const pagesBase = process.env.GITHUB_ACTIONS && repoName ? `/${repoName}/` : '/'

// https://vite.dev/config/
export default defineConfig({
  // base: pagesBase,
  base:'/agent-web-os/',
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] })
  ],
})
