package read

// message is a parsed conversation message backed by an order-preserving
// jsonValue, mirroring the TS ConversationMessage interface fields that read.ts
// actually inspects.
type message struct {
	raw *jsonObject
}

func messageFromValue(v jsonValue) (message, bool) {
	o, ok := asObject(v)
	if !ok {
		return message{}, false
	}
	return message{raw: o}, true
}

func (m message) typ() string {
	if v, ok := m.raw.get("type"); ok {
		if s, ok := asString(v); ok {
			return s
		}
	}
	return ""
}

func (m message) timestamp() string {
	if v, ok := m.raw.get("timestamp"); ok {
		if s, ok := asString(v); ok {
			return s
		}
	}
	return ""
}

func (m message) isSidechain() bool {
	if v, ok := m.raw.get("isSidechain"); ok {
		if b, ok := v.(jsonBool); ok {
			return bool(b)
		}
	}
	return false
}

func (m message) uuid() string {
	if v, ok := m.raw.get("uuid"); ok {
		if s, ok := asString(v); ok {
			return s
		}
	}
	return ""
}

// messageObject returns the nested "message" object, if present.
func (m message) messageObject() (*jsonObject, bool) {
	v, ok := m.raw.get("message")
	if !ok {
		return nil, false
	}
	return asObject(v)
}

// hasMessageContent mirrors `!msg.message || !msg.message.content`. In JS a
// falsy content is: missing, null, empty string, 0, false. read.ts only ever
// produces string | array content, so we treat missing/null/empty-string as
// falsy. Returns (contentValue, present-and-truthy).
func (m message) content() (jsonValue, bool) {
	msgObj, ok := m.messageObject()
	if !ok {
		return nil, false
	}
	c, ok := msgObj.get("content")
	if !ok {
		return nil, false
	}
	switch v := c.(type) {
	case jsonNull:
		return nil, false
	case jsonString:
		if string(v) == "" {
			return v, false
		}
		return v, true
	default:
		return c, true
	}
}

// hasUsage mirrors `msg.message?.usage`.
func (m message) hasUsage() bool {
	msgObj, ok := m.messageObject()
	if !ok {
		return false
	}
	v, ok := msgObj.get("usage")
	if !ok {
		return false
	}
	if _, isNull := v.(jsonNull); isNull {
		return false
	}
	return true
}

// toolUseResult returns the top-level toolUseResult field if present and
// truthy (non-null, non-empty-string).
func (m message) toolUseResult() (jsonValue, bool) {
	v, ok := m.raw.get("toolUseResult")
	if !ok {
		return nil, false
	}
	switch t := v.(type) {
	case jsonNull:
		return nil, false
	case jsonString:
		if string(t) == "" {
			return t, false
		}
		return t, true
	default:
		return v, true
	}
}

// metadataField returns a top-level string field (sessionId, gitBranch, cwd,
// version) if present and non-empty (mirrors JS truthiness for those fields).
func (m message) metadataField(key string) (string, bool) {
	v, ok := m.raw.get(key)
	if !ok {
		return "", false
	}
	s, ok := asString(v)
	if !ok || s == "" {
		return "", false
	}
	return s, true
}
