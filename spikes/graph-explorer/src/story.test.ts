import { Option } from 'effect'
import { Story } from 'foldkit'
import { expect, test } from 'vitest'

import { RunSelect } from './command'
import { update } from './main'
import { catalogNodes, loadedModel, loadingModel } from './main.fixtures'
import {
  ClickedClear,
  ClickedRun,
  FailedRunSelect,
  SucceededFetchCatalog,
  SucceededRunSelect,
  ToggledField,
  ToggledFollow,
} from './message'
import { Model } from './model'

const selectedModel: Model = {
  ...loadedModel,
  selections: { 'news/stories': { fields: ['title'], follows: {} } },
  maybeEntry: Option.some('news/stories'),
}

test('loading the catalog lays out each site canvas', () => {
  Story.story(
    update,
    Story.with(loadingModel),
    Story.message(SucceededFetchCatalog({ nodes: catalogNodes })),
    Story.model(model => {
      expect(model.catalog._tag).toBe('Success')
      expect(model.positions['news.example.com']).toBeDefined()
      expect(
        model.positions['news.example.com']?.['news/stories'],
      ).toBeDefined()
    }),
  )
})

test('ticking a field selects it and adopts the lens as entry', () => {
  Story.story(
    update,
    Story.with(loadedModel),
    Story.message(ToggledField({ lens: 'news/stories', path: 'title' })),
    Story.model(model => {
      expect(model.selections['news/stories']?.fields).toEqual(['title'])
      expect(Option.contains(model.maybeEntry, 'news/stories')).toBe(true)
    }),
    Story.message(ToggledField({ lens: 'news/stories', path: 'title' })),
    Story.model(model => {
      expect(model.selections['news/stories']?.fields).toEqual([])
    }),
  )
})

test('ticking an edge follows it with the default limit', () => {
  Story.story(
    update,
    Story.with(loadedModel),
    Story.message(ToggledFollow({ lens: 'news/stories', path: 'item' })),
    Story.model(model => {
      expect(model.selections['news/stories']?.follows).toEqual({ item: 3 })
    }),
  )
})

test('running the plan resolves data and annotates samples', () => {
  Story.story(
    update,
    Story.with(selectedModel),
    Story.message(ClickedRun()),
    Story.model(model => {
      expect(model.run._tag).toBe('Loading')
    }),
    Story.Command.resolve(
      RunSelect,
      SucceededRunSelect({ data: [{ title: 'First story' }] }),
    ),
    Story.model(model => {
      expect(model.run._tag).toBe('Success')
      expect(model.samples['news/stories']?.['title']).toBe('First story')
    }),
  )
})

test('a failed run surfaces the error', () => {
  Story.story(
    update,
    Story.with(selectedModel),
    Story.message(ClickedRun()),
    Story.Command.resolve(
      RunSelect,
      FailedRunSelect({ error: 'broker unreachable' }),
    ),
    Story.model(model => {
      expect(model.run._tag).toBe('Failure')
      if (model.run._tag === 'Failure') {
        expect(model.run.error).toBe('broker unreachable')
      }
    }),
  )
})

test('running with nothing selected is ignored', () => {
  Story.story(
    update,
    Story.with(loadedModel),
    Story.message(ClickedRun()),
    Story.model(model => {
      expect(model.run._tag).toBe('Idle')
    }),
  )
})

test('clear resets selection, entry, and result', () => {
  Story.story(
    update,
    Story.with(selectedModel),
    Story.message(ClickedClear()),
    Story.model(model => {
      expect(model.selections).toEqual({})
      expect(Option.isNone(model.maybeEntry)).toBe(true)
      expect(model.run._tag).toBe('Idle')
      expect(model.samples).toEqual({})
    }),
  )
})
