import { Option } from 'effect'
import { Story } from 'foldkit'
import { expect, test } from 'vitest'

import { RunSelect } from './command'
import { currentPlan, currentSamples } from './derive'
import { update } from './main'
import { catalogNodes, loadedModel, loadingModel } from './main.fixtures'
import {
  ClickedClear,
  ClickedRun,
  ClickedSetEntry,
  FailedRunSelect,
  MovedPointer,
  PressedPaneDivider,
  ReleasedPointer,
  SucceededFetchCatalog,
  SucceededRunSelect,
  ToggledField,
  ToggledFollow,
} from './message'
import { Model } from './model'
import { SiteRoute } from './route'

const selectedModel: Model = {
  ...loadedModel,
  selections: { 'news/stories': { fields: ['title'], follows: {} } },
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

test('ticking a field selects it; unticking the last removes the selection', () => {
  Story.story(
    update,
    Story.with(loadedModel),
    Story.message(ToggledField({ lens: 'news/stories', path: 'title' })),
    Story.model(model => {
      expect(model.selections['news/stories']?.fields).toEqual(['title'])
      expect(Option.map(currentPlan(model), plan => plan.lens)).toEqual(
        Option.some('news/stories'),
      )
    }),
    Story.message(ToggledField({ lens: 'news/stories', path: 'title' })),
    Story.model(model => {
      expect(model.selections['news/stories']).toBeUndefined()
      expect(Option.isNone(currentPlan(model))).toBe(true)
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

test('the entry derives from the root of the followed graph', () => {
  Story.story(
    update,
    Story.with(loadedModel),
    Story.message(ToggledField({ lens: 'news/item', path: 'text' })),
    Story.model(model => {
      expect(Option.map(currentPlan(model), plan => plan.lens)).toEqual(
        Option.some('news/item'),
      )
    }),
    Story.message(ToggledField({ lens: 'news/stories', path: 'title' })),
    Story.message(ToggledFollow({ lens: 'news/stories', path: 'item' })),
    Story.model(model => {
      // stories follows into item, so stories becomes the root despite item
      // being ticked first
      const plan = Option.getOrThrow(currentPlan(model))
      expect(plan.lens).toBe('news/stories')
      expect(plan.follows.map(follow => follow.select.lens)).toEqual([
        'news/item',
      ])
      expect(plan.params).toEqual({ page: 1 })
    }),
  )
})

test('a preferred entry is honoured only while it has ticks', () => {
  Story.story(
    update,
    Story.with(loadedModel),
    Story.message(ToggledField({ lens: 'news/stories', path: 'title' })),
    Story.message(ToggledField({ lens: 'news/item', path: 'text' })),
    Story.message(ClickedSetEntry({ lens: 'news/item' })),
    Story.model(model => {
      expect(Option.map(currentPlan(model), plan => plan.lens)).toEqual(
        Option.some('news/item'),
      )
    }),
    Story.message(ToggledField({ lens: 'news/item', path: 'text' })),
    Story.model(model => {
      expect(Option.map(currentPlan(model), plan => plan.lens)).toEqual(
        Option.some('news/stories'),
      )
    }),
  )
})

test('running the plan resolves data and derives samples', () => {
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
      expect(currentSamples(model)['news/stories']?.['title']).toBe(
        'First story',
      )
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

test('ticking on the site being viewed re-roots the plan there', () => {
  Story.story(
    update,
    Story.with({
      ...loadedModel,
      route: SiteRoute({ host: 'blog.example.com' }),
      selections: { 'news/stories': { fields: ['title'], follows: {} } },
    }),
    Story.model(model => {
      // only ticks elsewhere: the plan falls back to them
      expect(Option.map(currentPlan(model), plan => plan.lens)).toEqual(
        Option.some('news/stories'),
      )
    }),
    Story.message(ToggledField({ lens: 'blog/posts', path: 'heading' })),
    Story.model(model => {
      expect(Option.map(currentPlan(model), plan => plan.lens)).toEqual(
        Option.some('blog/posts'),
      )
    }),
  )
})

test('dragging the divider left widens the result pane', () => {
  Story.story(
    update,
    Story.with(loadedModel),
    Story.message(PressedPaneDivider({ clientX: 800 })),
    Story.message(MovedPointer({ clientX: 700, clientY: 0 })),
    Story.model(model => {
      expect(model.resultPaneWidth).toBe(720)
    }),
    Story.message(ReleasedPointer()),
    Story.model(model => {
      expect(Option.isNone(model.maybePaneResize)).toBe(true)
    }),
  )
})

test('clear resets selection, entry, and result', () => {
  Story.story(
    update,
    Story.with({
      ...selectedModel,
      maybePreferredEntry: Option.some('news/stories'),
    }),
    Story.message(ClickedClear()),
    Story.model(model => {
      expect(model.selections).toEqual({})
      expect(Option.isNone(model.maybePreferredEntry)).toBe(true)
      expect(model.run._tag).toBe('Idle')
      expect(currentSamples(model)).toEqual({})
    }),
  )
})
