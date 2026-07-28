import { Scene } from 'foldkit'
import { describe, test } from 'vitest'

import { update, view } from './main'
import { loadedModel, siteModel } from './main.fixtures'
import { Model, RunAsyncData } from './model'

describe('sites index', () => {
  test('lists each host from the catalog', () => {
    Scene.scene(
      { update, view },
      Scene.with(loadedModel),
      Scene.expect(Scene.text('news.example.com')).toExist(),
      Scene.expect(Scene.text('stories · item')).toExist(),
    )
  })
})

describe('site canvas', () => {
  test('renders lens cards with tickable rows and the query pane', () => {
    Scene.scene(
      { update, view },
      Scene.with(siteModel),
      Scene.expect(Scene.text('stories')).toExist(),
      Scene.expect(Scene.text('tick fields on a site graph…')).toExist(),
      Scene.expect(Scene.role('button', { name: 'Run' })).toExist(),
      Scene.expect(Scene.role('button', { name: 'Clear' })).toExist(),
    )
  })

  test('ticking a field produces a plan and a cost estimate', () => {
    Scene.scene(
      { update, view },
      Scene.with(siteModel),
      Scene.click(Scene.role('checkbox', { name: 'points' })),
      Scene.expect(Scene.text('≈ 1 page loads (cache permitting)')).toExist(),
    )
  })
})

describe('result pane', () => {
  const modelWithData: Model = {
    ...siteModel,
    selections: { 'news/stories': { fields: ['title'], follows: {} } },
    run: RunAsyncData.Success({
      data: [{ title: 'First story' }, { title: 'Second story' }],
    }),
  }

  test('shows the join table with a row count', () => {
    Scene.scene(
      { update, view },
      Scene.with(modelWithData),
      Scene.expect(Scene.text('2 rows')).toExist(),
      Scene.expect(Scene.text('First story')).toExist(),
    )
  })

  test('switches to the tree view', () => {
    Scene.scene(
      { update, view },
      Scene.with(modelWithData),
      Scene.click(Scene.role('button', { name: 'tree' })),
      Scene.expect(Scene.text('Second story')).toExist(),
    )
  })
})
