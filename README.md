# rtcfire (WIP)

A simple WebRTC + Firebase Realtime Database JS library for multi-user video chat.

**WARNING: This library is experimental, and not battle-tested. Bug reports and PRs welcome.**

# Installation

Install with npm:

    npm install rtcfire

# Dependencies

The only dependency is the [Firebase JS SDK](https://firebase.google.com/docs/reference/js)
(`npm install firebase`), which is a peer dependency and not directly `require`d by this library.

# Usage

```js
import { rtcFireSession } from 'rtcfire';

let session = rtcFireSession({
  // list of user IDs, including your own!
  // when the set of participants changes, call:
  //   session.participants = [user.uid, 'uid1'];
  participants: [user.uid, 'uid1', 'uid2', ...],
  // the current user's uid, probably from Firebase Auth
  myId: user.uid,
  // root path for WebRTC negotiation
  // (don't forget to protect these behind security rules!)
  // (call firebase.initializeApp(config) before calling this)
  negotiationRef: firebase.database().ref('rtcnegotiations'),
  // Set the local <video> stream
  onMyStream: stream => myVideo.srcObject = stream,
  // Set the <video> stream for the given participant
  onParticipantStream: (pid, stream) => videos[pid].srcObject = stream,
});
```

# Security rules

Don't forget to write appropriate security rules for your Realtime Database! See [example_rtdb_rules.rules] for an example that uses the default `negotiationRef` paths.

# License

Apache 2.0 (see [LICENSE](LICENSE))
