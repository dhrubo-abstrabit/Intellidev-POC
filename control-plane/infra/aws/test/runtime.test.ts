import { describe, expect, it } from 'vitest'
import { Template } from 'aws-cdk-lib/assertions'
import { buildApp } from '../lib/build-app.js'

const ACCOUNT = '111111111111'

let cached: Template | undefined
function template(): Template {
  if (!cached) {
    const { runtime } = buildApp({ env: 'dev', ambientAccount: ACCOUNT })
    cached = Template.fromStack(runtime)
  }
  return cached
}

describe('what the control plane is told to run', () => {
  it('publishes the task definition family, not a pinned revision', () => {
    /**
     * FOUND BY DEPLOYING IT. Pushing a new image registers a new task definition revision and
     * CDK deregisters the one it replaces — so a control plane that resolved the ARN at boot
     * kept dispatching against a revision that no longer existed, and every run failed with
     * `TaskDefinition is inactive`. Restarting it would have fixed each occurrence and taught
     * nobody anything.
     *
     * A family resolves to the latest ACTIVE revision at RunTask time, which is also what makes
     * a new image take effect without restarting the control plane.
     */
    const params = Object.values(template().findResources('AWS::SSM::Parameter')).filter((p) =>
      String(p.Properties?.Name ?? '').endsWith('run-task-definition-arn'),
    )
    expect(params).toHaveLength(1)
    // What must not appear is a revision-bearing ARN; a family is just the definition's name.
    expect(JSON.stringify(params[0]?.Properties?.Value)).not.toMatch(/:task-definition\//)
  })
})
