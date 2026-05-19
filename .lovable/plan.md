The error is not coming from the app’s sync logic. The app is calling Gmail’s `/users/me/watch` with this topic:

```text
projects/projectinboxzero-495314/topics/gmail-push
```

Google is rejecting Gmail’s test publish because the special Gmail service account does not have publish access to that exact topic.

## Fix in Google Cloud

1. Open Google Cloud Console for project `projectinboxzero-495314`.
2. Go to **Pub/Sub → Topics → gmail-push**.
3. Open the topic’s **Permissions** tab.
4. Click **Grant access** / **Add principal**.
5. Add this principal exactly:

```text
gmail-api-push@system.gserviceaccount.com
```

6. Grant this role:

```text
Pub/Sub Publisher
```

If the UI still does not show “Pub/Sub Publisher”, use the Google Cloud Shell command instead:

```bash
gcloud pubsub topics add-iam-policy-binding projects/projectinboxzero-495314/topics/gmail-push \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## Important checks

- Make sure you add the permission on the **topic**, not only project-level IAM.
- Make sure the topic is in project `projectinboxzero-495314`, because that is the project shown in the error.
- The top warning about “messages will be lost unless you add a subscription or retention” is separate. It will not cause this 403, but you should still add a subscription after the watch permission works.

## Then test

After saving the permission, go back to the app and click **Renew push watch** first. If that succeeds, click **Sync now**.