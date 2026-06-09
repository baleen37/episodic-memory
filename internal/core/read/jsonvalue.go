package read

import (
	"bytes"
	"encoding/json"
)

// jsonValue is an order-preserving JSON value. Standard map[string]any loses
// object key order, but read.ts relies on insertion order in two places:
//   - formatToolInput iterates Object.entries(input) in key order
//   - JSON.stringify(value, null, 2) emits keys in insertion order
//
// jsonValue mirrors JS values:
//   - object  -> *jsonObject (ordered key/value pairs)
//   - array   -> jsonArray
//   - string  -> jsonString
//   - number  -> json.Number (preserved exactly as written)
//   - bool    -> jsonBool
//   - null    -> jsonNull
type jsonValue interface {
	isJSONValue()
}

type jsonObject struct {
	keys   []string
	values map[string]jsonValue
}

func newJSONObject() *jsonObject {
	return &jsonObject{values: map[string]jsonValue{}}
}

func (o *jsonObject) set(k string, v jsonValue) {
	if _, ok := o.values[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.values[k] = v
}

func (o *jsonObject) get(k string) (jsonValue, bool) {
	v, ok := o.values[k]
	return v, ok
}

type jsonArray []jsonValue
type jsonString string
type jsonBool bool
type jsonNull struct{}

func (*jsonObject) isJSONValue() {}
func (jsonArray) isJSONValue()   {}
func (jsonString) isJSONValue()  {}
func (jsonBool) isJSONValue()    {}
func (jsonNull) isJSONValue()    {}

// json.Number also needs the marker; wrap it.
type jsonNumber json.Number

func (jsonNumber) isJSONValue() {}

// MarshalJSON for jsonObject preserves key order.
func (o *jsonObject) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, k := range o.keys {
		if i > 0 {
			buf.WriteByte(',')
		}
		kb, err := marshalNoEscape(jsonString(k))
		if err != nil {
			return nil, err
		}
		buf.Write(kb)
		buf.WriteByte(':')
		vb, err := marshalValue(o.values[k])
		if err != nil {
			return nil, err
		}
		buf.Write(vb)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

func (a jsonArray) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('[')
	for i, v := range a {
		if i > 0 {
			buf.WriteByte(',')
		}
		vb, err := marshalValue(v)
		if err != nil {
			return nil, err
		}
		buf.Write(vb)
	}
	buf.WriteByte(']')
	return buf.Bytes(), nil
}

func (s jsonString) MarshalJSON() ([]byte, error) { return marshalNoEscape(s) }
func (b jsonBool) MarshalJSON() ([]byte, error) {
	if b {
		return []byte("true"), nil
	}
	return []byte("false"), nil
}
func (jsonNull) MarshalJSON() ([]byte, error)     { return []byte("null"), nil }
func (n jsonNumber) MarshalJSON() ([]byte, error) { return []byte(string(n)), nil }

// marshalValue serializes a nested jsonValue without HTML escaping. It must NOT
// route through json.Marshal: even when a type implements MarshalJSON returning
// unescaped bytes, json.Marshal re-compacts the result with HTML escaping
// enabled (escaping <, >, & to < etc.), which diverges from JS
// JSON.stringify. We dispatch on the concrete type instead so nested objects,
// arrays, and string leaves all stay unescaped.
func marshalValue(v jsonValue) ([]byte, error) {
	switch t := v.(type) {
	case nil:
		return []byte("null"), nil
	case *jsonObject:
		return t.MarshalJSON()
	case jsonArray:
		return t.MarshalJSON()
	case jsonString:
		return marshalNoEscape(t)
	case jsonBool:
		return t.MarshalJSON()
	case jsonNull:
		return []byte("null"), nil
	case jsonNumber:
		return []byte(string(t)), nil
	default:
		return []byte("null"), nil
	}
}

func marshalNoEscape(s jsonString) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(string(s)); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// parseJSONValue decodes a JSON document into an order-preserving jsonValue.
func parseJSONValue(data []byte) (jsonValue, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := decodeValue(dec)
	if err != nil {
		return nil, err
	}
	return v, nil
}

func decodeValue(dec *json.Decoder) (jsonValue, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	return decodeFromToken(dec, tok)
}

func decodeFromToken(dec *json.Decoder, tok json.Token) (jsonValue, error) {
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			obj := newJSONObject()
			for dec.More() {
				keyTok, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key := keyTok.(string)
				val, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				obj.set(key, val)
			}
			// consume closing '}'
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return obj, nil
		case '[':
			arr := jsonArray{}
			for dec.More() {
				val, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, val)
			}
			// consume closing ']'
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return arr, nil
		}
		return nil, &json.SyntaxError{}
	case string:
		return jsonString(t), nil
	case json.Number:
		return jsonNumber(t), nil
	case bool:
		return jsonBool(t), nil
	case nil:
		return jsonNull{}, nil
	}
	return jsonNull{}, nil
}

// asString returns (value, true) when v is a JSON string.
func asString(v jsonValue) (string, bool) {
	s, ok := v.(jsonString)
	return string(s), ok
}

// asArray returns (value, true) when v is a JSON array.
func asArray(v jsonValue) (jsonArray, bool) {
	a, ok := v.(jsonArray)
	return a, ok
}

// asObject returns (value, true) when v is a JSON object.
func asObject(v jsonValue) (*jsonObject, bool) {
	o, ok := v.(*jsonObject)
	return o, ok
}
