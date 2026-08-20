#!/usr/bin/env node
import { buildApp } from '../lib/build-app.js'

// Context and the output directory come from the CDK CLI via the environment; the App
// auto-synthesises on exit.
buildApp()
