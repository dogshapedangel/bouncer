tired of banning your own ip from your discord server?

this little tool was born out of the reality that if you sign users up at a specific IP and then ban them, nobody from your IP can join the server anymore.

/bounce to kickban joins on a list
- user: mention, @handle, or Discord user ID
- reason: reason for the bounce
- member_id (optional): external non-Discord member number

/unbounce to remove the kickban
- user: mention, @handle, or Discord user ID

```text
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot%20applications.commands&permissions=76802
```

running manually:

```bash
npm install
npm start
```

docker compose:

```bash
docker compose up --build -d
```