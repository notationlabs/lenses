import { Option, Schema as S, Stream } from 'effect'
import { Subscription } from 'foldkit'

import { Message, MovedPointer, ReleasedPointer } from './message'
import { Model } from './model'

export const subscriptions = Subscription.make<Model, Message>()(entry => ({
  cardDrag: entry(
    { isDragging: S.Boolean },
    {
      modelToDependencies: model => ({
        isDragging:
          Option.isSome(model.maybeDrag) ||
          Option.isSome(model.maybePaneResize),
      }),
      dependenciesToStream: ({ isDragging }) =>
        isDragging
          ? Stream.merge(
              Stream.fromEventListener<PointerEvent>(
                window,
                'pointermove',
              ).pipe(
                Stream.map(event =>
                  MovedPointer({
                    clientX: event.clientX,
                    clientY: event.clientY,
                  }),
                ),
              ),
              Stream.fromEventListener(window, 'pointerup').pipe(
                Stream.map(() => ReleasedPointer()),
              ),
            )
          : Stream.empty,
    },
  ),
}))
