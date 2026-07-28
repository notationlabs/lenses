import { Runtime } from 'foldkit'

import { overlay } from '@foldkit/devtools'

import { Message, Model, init, update, view } from './main'
import { ChangedUrl, ClickedLink } from './message'
import { subscriptions } from './subscription'

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  subscriptions,
  container: document.getElementById('root'),
  routing: {
    onUrlRequest: request => ClickedLink({ request }),
    onUrlChange: url => ChangedUrl({ url }),
  },
  devTools: {
    overlay,
    Message,
  },
})

Runtime.run(application)
